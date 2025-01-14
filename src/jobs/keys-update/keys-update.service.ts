import { Inject, Injectable } from '@nestjs/common';
import { LOGGER_PROVIDER, LoggerService } from 'common/logger';
import { PrometheusService } from 'common/prometheus';
import { ConfigService } from 'common/config';
import { JobService } from 'common/job';
import { CuratedModuleService, STAKING_MODULE_TYPE } from '../../staking-router-modules/';
import { RegistryOperator, RegistryMeta } from '@lido-nestjs/registry';
import { StakingRouterFetchService, StakingModule } from 'common/contracts';
import { ExecutionProviderService } from 'common/execution-provider';
import { ModuleId } from 'http/common/entities';
import { Trace } from 'common/decorators/trace';
import { OneAtTime } from 'common/decorators/oneAtTime';
import { SchedulerRegistry } from '@nestjs/schedule';

const METRICS_TIMEOUT = 30 * 1000;

class KeyOutdatedError extends Error {
  lastBlock: number;

  constructor(message, lastBlock) {
    super(message);
    this.lastBlock = lastBlock;
  }
}

@Injectable()
export class KeysUpdateService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly prometheusService: PrometheusService,
    protected readonly configService: ConfigService,
    protected readonly jobService: JobService,
    protected readonly curatedModuleService: CuratedModuleService,
    protected readonly stakingRouterFetchService: StakingRouterFetchService,
    protected readonly executionProvider: ExecutionProviderService,
    protected readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  // prometheus metrics
  protected lastTimestampSec: number | undefined = undefined;
  protected lastBlockNumber: number | undefined = undefined;
  protected curatedNonce: number | undefined = undefined;
  protected curatedOperators: RegistryOperator[] = [];

  // list of staking modules
  // modules list is used in endpoints
  // TODO: move this list in staking-router-modules folder
  protected stakingModules: StakingModule[] = [];

  // name of interval for updating keys
  public UPDATE_KEYS_JOB_NAME = 'SRModulesKeysUpdate';
  // timeout for update keys
  // if during 30 minutes nothing happen we will exit
  UPDATE_KEYS_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  updateDeadlineTimer: undefined | NodeJS.Timeout = undefined;

  /**
   * Initializes the job
   */
  public async initialize(): Promise<void> {
    // at first start timer for checking update
    // if timer isnt cleared in 30 minutes period, we will consider it as nodejs frizzing and exit
    this.checkKeysUpdateTimeout();
    await this.updateKeys().catch((error) => this.logger.error(error));

    const interval_ms = this.configService.get('UPDATE_KEYS_INTERVAL_MS');
    const interval = setInterval(() => this.updateKeys().catch((error) => this.logger.error(error)), interval_ms);
    this.schedulerRegistry.addInterval(this.UPDATE_KEYS_JOB_NAME, interval);

    this.logger.log('Finished KeysUpdateService initialization');
  }

  private checkKeysUpdateTimeout() {
    const currTimestampSec = new Date().getTime() / 1000;
    // currTimestampSec - this.lastTimestampSec - time since last update in seconds
    // this.UPDATE_KEYS_TIMEOUT_MS / 1000 - timeout in seconds
    // so if time since last update is less than timeout, this means keys are updated
    const isUpdated =
      this.lastTimestampSec && currTimestampSec - this.lastTimestampSec < this.UPDATE_KEYS_TIMEOUT_MS / 1000;

    if (this.updateDeadlineTimer && isUpdated) clearTimeout(this.updateDeadlineTimer);

    this.updateDeadlineTimer = setTimeout(async () => {
      const error = new KeyOutdatedError(
        `There were no keys update more than ${this.UPDATE_KEYS_TIMEOUT_MS / (1000 * 60)} minutes`,
        this.lastBlockNumber,
      );
      this.logger.error(error);
      process.exit(1);
    }, this.UPDATE_KEYS_TIMEOUT_MS);
  }

  public getStakingModules() {
    return this.stakingModules;
  }

  public getStakingModule(moduleId: ModuleId): StakingModule | undefined {
    // here should be == , moduleId can be string and number
    return this.stakingModules.find((module) => module.stakingModuleAddress == moduleId || module.id == moduleId);
  }

  /**
   * Collects updates from the registry contract and saves the changes to the database
   */
  @OneAtTime()
  private async updateKeys(): Promise<void> {
    await this.jobService.wrapJob({ name: 'Update Staking Router Modules keys' }, async () => {
      // get blockHash for 'latest' block
      const blockHash = await this.executionProvider.getBlockHash('latest');

      // get staking router modules
      const modules = await this.stakingRouterFetchService.getStakingModules({ blockHash: blockHash });
      this.stakingModules = modules;

      // Here should be a transaction in future that will wrap updateKeys calls of all modules
      // or other way to call updateKeys method consistently

      await Promise.all(
        this.stakingModules.map(async (stakingModule) => {
          if (stakingModule.type === STAKING_MODULE_TYPE.CURATED_ONCHAIN_V1_TYPE) {
            this.logger.log('Start updating curated keys');
            await this.curatedModuleService.updateKeys(blockHash);
          }
        }),
      );

      // Update cached data to quick access
      await this.updateMetricsCache();

      this.setMetrics();

      // update finished
      // clear timeout
      this.checkKeysUpdateTimeout();
    });
  }

  /**
   * Update cache data above
   */
  @Trace(METRICS_TIMEOUT)
  private async updateMetricsCache() {
    const meta = await this.updateCuratedMetricsCache();
    // update meta
    // timestamp and block number is common for all modules
    this.lastTimestampSec = meta?.timestamp ?? this.lastTimestampSec;
    this.lastBlockNumber = meta?.blockNumber ?? this.lastBlockNumber;
  }

  private async updateCuratedMetricsCache(): Promise<RegistryMeta | null> {
    const { operators, meta } = await this.curatedModuleService.getOperatorsWithMeta();
    // should set for each module
    this.curatedNonce = meta?.keysOpIndex ?? this.curatedNonce;
    // update curated module operators map
    this.curatedOperators = operators;

    return meta;
  }

  /**
   * Updates prometheus metrics
   */
  private setMetrics() {
    // common metrics
    if (this.lastTimestampSec) {
      this.prometheusService.registryLastUpdate.set(this.lastTimestampSec);
    }
    if (this.lastBlockNumber) {
      this.prometheusService.registryBlockNumber.set(this.lastBlockNumber);
    }

    // curated metrics
    this.setCuratedMetrics();
  }

  private setCuratedMetrics() {
    if (this.curatedNonce) {
      this.prometheusService.registryNonce.set({ srModuleId: 1 }, this.curatedNonce);
    }
    this.setCuratedOperatorsMetric();

    this.logger.log('Curated Module metrics updated');
  }

  private setCuratedOperatorsMetric() {
    this.prometheusService.registryNumberOfKeysBySRModuleAndOperator.reset();

    this.curatedOperators.forEach((operator) => {
      this.prometheusService.registryNumberOfKeysBySRModuleAndOperator.set(
        {
          operator: operator.index,
          srModuleId: 1,
          used: 'true',
        },
        operator.usedSigningKeys,
      );

      this.prometheusService.registryNumberOfKeysBySRModuleAndOperator.set(
        {
          operator: operator.index,
          srModuleId: 1,
          used: 'false',
        },
        operator.totalSigningKeys - operator.usedSigningKeys,
      );
    });
  }
}

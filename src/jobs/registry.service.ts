import { CronJob } from 'cron';
import { Inject, Injectable } from '@nestjs/common';
import { OneAtTime } from '@lido-nestjs/decorators';
import {
  KeyRegistryService,
  RegistryKeyStorageService,
  RegistryMetaStorageService,
  RegistryKey,
  RegistryMeta,
} from '@lido-nestjs/registry';
import { LOGGER_PROVIDER, LoggerService } from 'common/logger';
import { PrometheusService } from 'common/prometheus';
import { ConfigService } from 'common/config';
import { JobService } from 'common/job';
import { EntityManager } from '@mikro-orm/postgresql';

@Injectable()
export class RegistryService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly logger: LoggerService,
    protected readonly keyRegistryService: KeyRegistryService,
    protected readonly keyStorageService: RegistryKeyStorageService,
    protected readonly metaStorageService: RegistryMetaStorageService,
    protected readonly prometheusService: PrometheusService,
    protected readonly configService: ConfigService,
    protected readonly jobService: JobService,
    private readonly entityManager: EntityManager,
  ) {}

  public async onModuleInit(): Promise<void> {
    // Do not wait for initialization to avoid blocking the main process
    this.initialize().catch((err) => this.logger.error(err));
  }

  /**
   * Initializes the job
   */
  public async initialize(): Promise<void> {
    await this.updateKeys();

    const cronTime = this.configService.get('JOB_INTERVAL_REGISTRY');
    const job = new CronJob(cronTime, () => this.updateKeys());
    job.start();

    this.logger.log('Service initialized', { service: 'registry', cronTime });
  }

  /**
   * Collects updates from the registry contract and saves the changes to the database
   */
  @OneAtTime()
  private async updateKeys(): Promise<void> {
    await this.jobService.wrapJob({ name: 'Update keys from NodeOperatorRegistry' }, async () => {
      await this.keyRegistryService.update('latest');
      await this.updateTimestamp();
      this.updateMetrics();
    });
  }

  protected lastTimestamp = 0;

  /**
   * Updates timestamp of the last registry update
   */
  private async updateTimestamp(): Promise<void> {
    const meta = await this.metaStorageService.get();
    this.lastTimestamp = meta?.timestamp ?? this.lastTimestamp;
  }

  public async getKeyWithMetaByPubkey(pubkey: string): Promise<{ keys: RegistryKey[]; meta: RegistryMeta | null }> {
    const { keys, meta } = await this.entityManager.transactional(async () => {
      const keys = await this.keyStorageService.findByPubkey(pubkey.toLocaleLowerCase());
      const meta = await this.getMetaDataFromStorage();

      return { keys, meta };
    });

    return { keys, meta };
  }

  public async getKeysWithMetaByPubkeys(pubkeys: string[]): Promise<{ keys: RegistryKey[]; meta: RegistryMeta | null }> {
    const { keys, meta } = await this.entityManager.transactional(async () => {
      const keys = await this.getKeysByPubkeys(pubkeys);
      const meta = await this.getMetaDataFromStorage();

      return { keys, meta };
    });

    return { keys, meta };
  }

  // TODO: add interface to filters
  public async getKeysWithMeta(filters): Promise<{ keys: RegistryKey[]; meta: RegistryMeta | null }> {
    const { keys, meta } = await this.entityManager.transactional(async () => {
      const keys = await this.keyStorageService.find(filters);
      const meta = await this.getMetaDataFromStorage();

      return { keys, meta };
    });

    return { keys, meta };
  }

  public async getMetaDataFromStorage(): Promise<RegistryMeta | null> {
    return await this.metaStorageService.get();
  }

  /**
   * Returns all keys found in db from pubkey list
   * @param pubKeys - public keys
   * @returns keys from DB
   */
  private async getKeysByPubkeys(pubKeys: string[]): Promise<RegistryKey[]> {
    return await this.keyStorageService.find({ key: { $in: pubKeys } });
  }

  /**
   * Updates prometheus metrics
   */
  private updateMetrics() {
    this.prometheusService.registryLastUpdate.set(this.lastTimestamp);

    this.logger.log('Registry metrics updated');
  }
}

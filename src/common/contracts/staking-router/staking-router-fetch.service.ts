import { Injectable, Inject, LoggerService } from '@nestjs/common';
import { StakingModule } from './staking-module';
import { LOGGER_PROVIDER } from '@lido-nestjs/logger';
import { IStakingModuleService } from 'common/contracts/i-staking-module';
import { STAKING_MODULE_TYPE } from 'staking-router-modules';
import { LidoLocatorService } from 'common/contracts/lido-locator';
import { StakingRouter__factory } from 'generated';
import { ExecutionProvider } from 'common/execution-provider';
import { BlockTag } from '../interfaces';

@Injectable()
export class StakingRouterFetchService {
  constructor(
    @Inject(LOGGER_PROVIDER) protected readonly loggerService: LoggerService,
    protected readonly iStakingModule: IStakingModuleService,
    protected readonly lidoLocatorService: LidoLocatorService,
    protected readonly provider: ExecutionProvider,
  ) {}

  private getContract(contractAddress: string) {
    return StakingRouter__factory.connect(contractAddress, this.provider);
  }

  /**
   *
   * @returns Staking Router modules list
   */
  public async getStakingModules(blockTag: BlockTag): Promise<StakingModule[]> {
    const stakingRouterAddress = await this.lidoLocatorService.getStakingRouter(blockTag);

    this.loggerService.debug?.('Staking router module address', stakingRouterAddress);

    const contract = this.getContract(stakingRouterAddress);
    const modules = await contract.getStakingModules({ blockTag } as any);

    this.loggerService.log(`Fetched ${modules.length} modules`);
    this.loggerService.debug?.(`Modules ${modules}`);

    const transformedModules = await Promise.all(
      modules.map(async (stakingModule) => {
        const isActive = await contract.getStakingModuleIsActive(stakingModule.id, { blockTag } as any);

        // until the end of voting work with old version of Node Operator Registry
        // this version doesnt correspond to IStakingModule interface
        // currently skip this section

        // const stakingModuleType = (await this.iStakingModule.getType(
        //   stakingModule.stakingModuleAddress,
        //   blockTag,
        // )) as STAKING_MODULE_TYPE;

        // if (!Object.values(STAKING_MODULE_TYPE).includes(stakingModuleType)) {
        //   throw new Error(`Staking Module type ${stakingModuleType} is unknown`);
        // }

        // lets put type by id as we know that list contains only NOR contract

        if (stakingModule.id != 1) {
          this.loggerService.error(new Error(`Staking Module id ${stakingModule.id} is unknown`));
          process.exit(1);
        }

        const stakingModuleType = STAKING_MODULE_TYPE.CURATED_ONCHAIN_V1_TYPE;

        return {
          id: stakingModule.id,
          stakingModuleAddress: stakingModule.stakingModuleAddress,
          stakingModuleFee: stakingModule.stakingModuleFee,
          treasuryFee: stakingModule.treasuryFee,
          targetShare: stakingModule.targetShare,
          status: stakingModule.status,
          name: stakingModule.name,
          type: stakingModuleType,
          lastDepositAt: stakingModule.lastDepositAt.toNumber(),
          lastDepositBlock: stakingModule.lastDepositBlock.toNumber(),
          exitedValidatorsCount: stakingModule.exitedValidatorsCount.toNumber(),
          // active: isActive,
        };
      }),
    );

    return transformedModules;
  }
}
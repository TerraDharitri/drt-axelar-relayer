import { forwardRef, Module } from '@nestjs/common';
import { GatewayContract } from './gateway.contract';
import { ApiNetworkProvider, ProxyNetworkProvider } from '@terradharitri/sdk-network-providers/out';
import { ResultsParser, TransactionWatcher } from '@terradharitri/sdk-core/out';
import { ContractLoader } from '@drt-monorepo/common/contracts/contract.loader';
import { join } from 'path';
import { GasServiceContract } from '@drt-monorepo/common/contracts/gas-service.contract';
import { ProviderKeys } from '@drt-monorepo/common/utils/provider.enum';
import { Mnemonic, UserSigner } from '@terradharitri/sdk-wallet/out';
import { TransactionsHelper } from '@drt-monorepo/common/contracts/transactions.helper';
import { WrewaSwapContract } from '@drt-monorepo/common/contracts/wrewa-swap.contract';
import { ApiConfigService } from '@drt-monorepo/common/config';
import { DynamicModuleUtils } from '@drt-monorepo/common/utils';
import { ItsContract } from '@drt-monorepo/common/contracts/its.contract';
import { FeeHelper } from '@drt-monorepo/common/contracts/fee.helper';
import { ApiModule } from '@drt-monorepo/common/api';

@Module({
  imports: [DynamicModuleUtils.getCacheModule(), forwardRef(() => ApiModule)],
  providers: [
    {
      provide: ProxyNetworkProvider,
      useFactory: (apiConfigService: ApiConfigService) => {
        return new ProxyNetworkProvider(apiConfigService.getGatewayUrl(), {
          timeout: apiConfigService.getGatewayTimeout(),
          clientName: 'axelar-drt-relayer',
        } as any);
      },
      inject: [ApiConfigService],
    },
    {
      provide: ApiNetworkProvider,
      useFactory: (apiConfigService: ApiConfigService) => {
        return new ApiNetworkProvider(apiConfigService.getApiUrl(), {
          timeout: apiConfigService.getApiTimeout(),
          clientName: 'axelar-drt-relayer',
        } as any);
      },
      inject: [ApiConfigService],
    },
    {
      provide: ResultsParser,
      useValue: new ResultsParser(),
    },
    {
      provide: TransactionWatcher,
      useFactory: (api: ApiNetworkProvider) => new TransactionWatcher(api), // use api here not proxy since it returns proper transaction status
      inject: [ApiNetworkProvider],
    },
    {
      provide: GatewayContract,
      useFactory: async (apiConfigService: ApiConfigService) => {
        const contractLoader = new ContractLoader(join(__dirname, '../assets/gateway.abi.json'));

        const smartContract = await contractLoader.getContract(apiConfigService.getContractGateway());
        const abi = await contractLoader.getAbiRegistry();

        return new GatewayContract(smartContract, abi, apiConfigService.getChainId());
      },
      inject: [ApiConfigService],
    },
    {
      provide: GasServiceContract,
      useFactory: async (apiConfigService: ApiConfigService) => {
        const contractLoader = new ContractLoader(join(__dirname, '../assets/gas-service.abi.json'));

        const smartContract = await contractLoader.getContract(apiConfigService.getContractGasService());
        const abi = await contractLoader.getAbiRegistry();

        return new GasServiceContract(smartContract, abi);
      },
      inject: [ApiConfigService],
    },
    {
      provide: ItsContract,
      useFactory: async (apiConfigService: ApiConfigService) => {
        const contractLoader = new ContractLoader(join(__dirname, '../assets/interchain-token-service.abi.json'));

        const smartContract = await contractLoader.getContract(apiConfigService.getContractIts());
        const abi = await contractLoader.getAbiRegistry();

        return new ItsContract(smartContract, abi);
      },
      inject: [ApiConfigService],
    },
    {
      provide: WrewaSwapContract,
      useFactory: async (
        apiConfigService: ApiConfigService,
        resultsParser: ResultsParser,
        proxy: ProxyNetworkProvider,
      ) => {
        const contractLoader = new ContractLoader(join(__dirname, '../assets/wrewa-swap.abi.json'));

        const smartContract = await contractLoader.getContract(apiConfigService.getContractWrewaSwap());

        return new WrewaSwapContract(smartContract, resultsParser, proxy);
      },
      inject: [ApiConfigService, ResultsParser, ProxyNetworkProvider],
    },
    {
      provide: ProviderKeys.WALLET_SIGNER,
      useFactory: (apiConfigService: ApiConfigService) => {
        const mnemonic = Mnemonic.fromString(apiConfigService.getWalletMnemonic()).deriveKey(0);

        return new UserSigner(mnemonic);
      },
      inject: [ApiConfigService, ResultsParser],
    },
    TransactionsHelper,
    FeeHelper,
  ],
  exports: [
    GatewayContract,
    GasServiceContract,
    ItsContract,
    WrewaSwapContract,
    ProviderKeys.WALLET_SIGNER,
    ProxyNetworkProvider,
    ApiNetworkProvider,
    TransactionsHelper,
    FeeHelper,
  ],
})
export class ContractsModule {}

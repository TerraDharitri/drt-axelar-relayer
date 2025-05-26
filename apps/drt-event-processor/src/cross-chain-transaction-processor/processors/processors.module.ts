import { forwardRef, Module } from '@nestjs/common';
import { GatewayProcessor } from './gateway.processor';
import { ContractsModule } from '@drt-monorepo/common/contracts/contracts.module';
import { DatabaseModule } from '@drt-monorepo/common';
import { ApiModule } from '@drt-monorepo/common/api/api.module';
import { GasServiceProcessor } from './gas-service.processor';
import { ItsProcessor } from './its.processor';

@Module({
  imports: [ContractsModule, DatabaseModule, forwardRef(() => ApiModule)],
  providers: [GatewayProcessor, GasServiceProcessor, ItsProcessor],
  exports: [GatewayProcessor, GasServiceProcessor, ItsProcessor],
})
export class ProcessorsModule {}

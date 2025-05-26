import { forwardRef, Module } from '@nestjs/common';
import { ApiConfigModule, DatabaseModule, DynamicModuleUtils } from '@drt-monorepo/common';
import { ApprovalsProcessorService } from './approvals.processor.service';
import { ApiModule } from '@drt-monorepo/common/api/api.module';
import { ContractsModule } from '@drt-monorepo/common/contracts/contracts.module';
import { ScheduleModule } from '@nestjs/schedule';
import { HelpersModule } from '@drt-monorepo/common/helpers/helpers.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ApiConfigModule,
    DynamicModuleUtils.getRedisCacheModule(),
    forwardRef(() => ApiModule),
    ContractsModule,
    DatabaseModule,
    HelpersModule,
  ],
  providers: [ApprovalsProcessorService],
})
export class ApprovalsProcessorModule {}

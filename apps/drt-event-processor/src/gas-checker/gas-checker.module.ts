import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ContractsModule } from '@drt-monorepo/common/contracts/contracts.module';
import { GasCheckerService } from './gas-checker.service';
import { ApiModule } from '@drt-monorepo/common';

@Module({
  imports: [ScheduleModule.forRoot(), ContractsModule, forwardRef(() => ApiModule)],
  providers: [GasCheckerService],
})
export class GasCheckerModule {}

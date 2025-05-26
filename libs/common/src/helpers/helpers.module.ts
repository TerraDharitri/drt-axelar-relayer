import { forwardRef, Module } from '@nestjs/common';
import { ApiModule, DynamicModuleUtils } from '@drt-monorepo/common';
import { RedisHelper } from '@drt-monorepo/common/helpers/redis.helper';
import { MetricsModule } from '@terradharitri/sdk-nestjs-monitoring';

@Module({
  imports: [
    DynamicModuleUtils.getRedisCacheModule(),
    DynamicModuleUtils.getRedisModule(),
    MetricsModule,
    forwardRef(() => ApiModule),
  ],
  providers: [RedisHelper],
  exports: [RedisHelper],
})
export class HelpersModule {}

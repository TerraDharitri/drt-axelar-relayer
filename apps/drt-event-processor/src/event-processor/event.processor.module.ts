import { RabbitModule, RabbitModuleOptions } from '@terradharitri/sdk-nestjs-rabbitmq';
import { forwardRef, Module } from '@nestjs/common';
import { EventProcessorService } from './event.processor.service';
import { ApiConfigModule, ApiConfigService, ApiModule } from '@drt-monorepo/common';
import { HelpersModule } from '@drt-monorepo/common/helpers/helpers.module';

@Module({
  imports: [
    ApiConfigModule,
    RabbitModule.forRootAsync({
      useFactory: (apiConfigService: ApiConfigService) =>
        new RabbitModuleOptions(apiConfigService.getEventsNotifierUrl(), [], {
          wait: false, // don't wait for connection to be available, will try to re-connect if connection is lost
        }),
      inject: [ApiConfigService],
    }),
    HelpersModule,
    forwardRef(() => ApiModule),
  ],
  providers: [EventProcessorService],
})
export class EventProcessorModule {}

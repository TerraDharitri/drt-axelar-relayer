import { NestFactory } from '@nestjs/core';
import { DrtEventProcessorModule } from './drt-event-processor.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(DrtEventProcessorModule);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
bootstrap();

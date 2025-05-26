import { Module } from '@nestjs/common';
import { PrismaService } from '@drt-monorepo/common/database/prisma.service';
import { MessageApprovedRepository } from '@drt-monorepo/common/database/repository/message-approved.repository';
import { LastProcessedDataRepository } from '@drt-monorepo/common/database/repository/last-processed-data.repository';

@Module({
  providers: [PrismaService, MessageApprovedRepository, LastProcessedDataRepository],
  exports: [MessageApprovedRepository, LastProcessedDataRepository],
})
export class DatabaseModule {}

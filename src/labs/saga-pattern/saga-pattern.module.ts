import { Module } from '@nestjs/common';

import { SagaInfrastructureModule } from './saga-infrastructure.module';
import { SagaPatternController } from './saga-pattern.controller';
import { SagaPatternService } from './saga-pattern.service';
import { SagaTimelineRecorder } from './timeline/saga-timeline-recorder.service';

@Module({
  imports: [SagaInfrastructureModule],
  controllers: [SagaPatternController],
  providers: [SagaPatternService, SagaTimelineRecorder],
})
export class SagaPatternModule {}

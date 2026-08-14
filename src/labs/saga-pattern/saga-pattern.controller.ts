import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import { SagaIdDto, StartSagaDto } from './dto/start-saga.dto';
import { sagaPatternLabConfig } from './lab.config';
import { SagaPatternService, type SagaStartedResponse } from './saga-pattern.service';
import type { SagaInstance, SagaTimelineEntry } from './shared/saga-status.types';

@Controller('labs/saga-pattern')
export class SagaPatternController {
  constructor(private readonly sagaPattern: SagaPatternService) {}

  @Get()
  getLabConfig(): typeof sagaPatternLabConfig {
    return sagaPatternLabConfig;
  }

  @Post('choreography/orders')
  startChoreography(@Body() request: StartSagaDto): Promise<SagaStartedResponse> {
    // 첫 이벤트만 발행하고 이후 단계는 각 서비스가 이벤트를 보고 결정한다.
    return this.sagaPattern.start('CHOREOGRAPHY', request);
  }

  @Post('orchestration/orders')
  startOrchestration(@Body() request: StartSagaDto): Promise<SagaStartedResponse> {
    // 주문 생성 결과를 Orchestrator에 전달해 중앙 상태 머신을 시작한다.
    return this.sagaPattern.start('ORCHESTRATION', request);
  }

  @Get('sagas/:sagaId')
  getSaga(@Param() sagaId: SagaIdDto): Promise<SagaInstance> {
    return this.sagaPattern.getSaga(sagaId.sagaId);
  }

  @Get('sagas/:sagaId/timeline')
  getTimeline(@Param() sagaId: SagaIdDto): Promise<SagaTimelineEntry[]> {
    return this.sagaPattern.getTimeline(sagaId.sagaId);
  }

  @Post('reset')
  reset(): Promise<{ reset: true }> {
    // 상태·타임라인·처리 이력·미발행 outbox를 함께 지워 다음 실험을 격리한다.
    return this.sagaPattern.reset();
  }
}

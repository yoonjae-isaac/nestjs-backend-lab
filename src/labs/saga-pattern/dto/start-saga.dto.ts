import { IsEnum, IsOptional, IsUUID } from 'class-validator';

import { SAGA_FAILURE_POINTS, type SagaFailurePoint } from '../shared/saga-status.types';

export class StartSagaDto {
  @IsOptional()
  @IsEnum(SAGA_FAILURE_POINTS)
  compensationFailAt: SagaFailurePoint = 'NONE';

  @IsOptional()
  @IsEnum(SAGA_FAILURE_POINTS)
  failAt: SagaFailurePoint = 'NONE';
}

export class SagaIdDto {
  @IsUUID()
  sagaId!: string;
}

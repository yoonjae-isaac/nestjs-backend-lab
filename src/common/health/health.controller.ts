import { Controller, Get } from '@nestjs/common';

import {
  HealthService,
  type HealthResponse,
  type InfrastructureHealthResponse,
} from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }

  @Get('infrastructure')
  getInfrastructureHealth(): Promise<InfrastructureHealthResponse> {
    return this.healthService.getInfrastructureHealth();
  }
}

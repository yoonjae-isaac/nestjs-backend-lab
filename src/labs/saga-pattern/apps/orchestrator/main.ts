import 'reflect-metadata';

import { bootstrapSagaWorker } from '../saga-worker.bootstrap';
import { SagaOrchestratorModule } from './saga-orchestrator.module';

void bootstrapSagaWorker(SagaOrchestratorModule);

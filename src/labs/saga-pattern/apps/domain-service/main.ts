import 'reflect-metadata';

import { bootstrapSagaWorker } from '../saga-worker.bootstrap';
import { SagaDomainServiceModule } from './saga-domain-service.module';

void bootstrapSagaWorker(SagaDomainServiceModule);

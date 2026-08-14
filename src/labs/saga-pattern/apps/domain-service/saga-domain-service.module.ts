import { Module } from '@nestjs/common';

import { ConfigModule } from '../../../../common/config/config.module';
import { LoggerModule } from '../../../../common/logger/logger.module';
import { InventoryChoreography } from '../../choreography/inventory/inventory.choreography';
import { OrderChoreography } from '../../choreography/order/order.choreography';
import { PaymentChoreography } from '../../choreography/payment/payment.choreography';
import { ShippingChoreography } from '../../choreography/shipping/shipping.choreography';
import { InventoryOrchestration } from '../../orchestration/inventory/inventory.orchestration';
import { OrderOrchestration } from '../../orchestration/order/order.orchestration';
import { PaymentOrchestration } from '../../orchestration/payment/payment.orchestration';
import { ShippingOrchestration } from '../../orchestration/shipping/shipping.orchestration';
import { SagaInfrastructureModule } from '../../saga-infrastructure.module';
import { SagaDomainWorker } from './saga-domain-worker.service';

@Module({
  imports: [ConfigModule, LoggerModule, SagaInfrastructureModule],
  providers: [
    SagaDomainWorker,
    OrderChoreography,
    InventoryChoreography,
    PaymentChoreography,
    ShippingChoreography,
    OrderOrchestration,
    InventoryOrchestration,
    PaymentOrchestration,
    ShippingOrchestration,
  ],
})
export class SagaDomainServiceModule {}

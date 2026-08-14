import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../../common/config/configuration';
import { InventoryChoreography } from '../../choreography/inventory/inventory.choreography';
import { OrderChoreography } from '../../choreography/order/order.choreography';
import { PaymentChoreography } from '../../choreography/payment/payment.choreography';
import { ShippingChoreography } from '../../choreography/shipping/shipping.choreography';
import { SagaConsumerService } from '../../messaging/saga-consumer.service';
import { InventoryOrchestration } from '../../orchestration/inventory/inventory.orchestration';
import { OrderOrchestration } from '../../orchestration/order/order.orchestration';
import { PaymentOrchestration } from '../../orchestration/payment/payment.orchestration';
import { ShippingOrchestration } from '../../orchestration/shipping/shipping.orchestration';
import { CHOREOGRAPHY_TOPICS, ORCHESTRATION_COMMAND_TOPICS } from '../../shared/saga.constants';
import type { SagaMessage } from '../../shared/saga-message.types';
import { SAGA_DOMAIN_SERVICES, type SagaDomainService } from '../../shared/saga-status.types';

@Injectable()
export class SagaDomainWorker implements OnModuleInit {
  private readonly config: AppConfig['sagaPattern'];

  constructor(
    configService: ConfigService,
    private readonly consumer: SagaConsumerService,
    private readonly orderChoreography: OrderChoreography,
    private readonly inventoryChoreography: InventoryChoreography,
    private readonly paymentChoreography: PaymentChoreography,
    private readonly shippingChoreography: ShippingChoreography,
    private readonly orderOrchestration: OrderOrchestration,
    private readonly inventoryOrchestration: InventoryOrchestration,
    private readonly paymentOrchestration: PaymentOrchestration,
    private readonly shippingOrchestration: ShippingOrchestration,
  ) {
    this.config = configService.getOrThrow<AppConfig['sagaPattern']>('app.sagaPattern');
  }

  async onModuleInit(): Promise<void> {
    const serviceRole = this.parseServiceRole();
    const choreographyTopics = this.choreographyTopics(serviceRole);

    // 동일 이미지라도 role별 consumer group과 topic만 연결해 독립 서비스 경계를 유지한다.
    await this.consumer.subscribe(
      `saga-pattern.choreography.${serviceRole.toLowerCase()}`,
      choreographyTopics,
      async (message) => this.handleChoreography(serviceRole, message),
    );
    await this.consumer.subscribe(
      `saga-pattern.orchestration.${serviceRole.toLowerCase()}`,
      [ORCHESTRATION_COMMAND_TOPICS[serviceRole]],
      async (message) => this.handleOrchestration(serviceRole, message),
    );
  }

  private parseServiceRole(): SagaDomainService {
    const serviceRole = this.config.serviceRole;
    if (!this.config.enabled || !SAGA_DOMAIN_SERVICES.includes(serviceRole as SagaDomainService)) {
      throw new Error(`Invalid SAGA_SERVICE_ROLE: ${serviceRole}`);
    }
    return serviceRole as SagaDomainService;
  }

  private choreographyTopics(serviceRole: SagaDomainService): string[] {
    switch (serviceRole) {
      case 'ORDER':
        return [CHOREOGRAPHY_TOPICS.INVENTORY, CHOREOGRAPHY_TOPICS.SHIPPING];
      case 'INVENTORY':
        return [CHOREOGRAPHY_TOPICS.ORDER, CHOREOGRAPHY_TOPICS.PAYMENT];
      case 'PAYMENT':
        return [CHOREOGRAPHY_TOPICS.INVENTORY, CHOREOGRAPHY_TOPICS.SHIPPING];
      case 'SHIPPING':
        return [CHOREOGRAPHY_TOPICS.PAYMENT];
    }
  }

  private async handleChoreography(
    serviceRole: SagaDomainService,
    message: SagaMessage,
  ): Promise<void> {
    if (message.kind !== 'EVENT' || message.strategy !== 'CHOREOGRAPHY') {
      return;
    }

    switch (serviceRole) {
      case 'ORDER':
        return this.orderChoreography.handle(message);
      case 'INVENTORY':
        return this.inventoryChoreography.handle(message);
      case 'PAYMENT':
        return this.paymentChoreography.handle(message);
      case 'SHIPPING':
        return this.shippingChoreography.handle(message);
    }
  }

  private async handleOrchestration(
    serviceRole: SagaDomainService,
    message: SagaMessage,
  ): Promise<void> {
    if (message.kind !== 'COMMAND' || message.strategy !== 'ORCHESTRATION') {
      return;
    }

    switch (serviceRole) {
      case 'ORDER':
        return this.orderOrchestration.handle(message);
      case 'INVENTORY':
        return this.inventoryOrchestration.handle(message);
      case 'PAYMENT':
        return this.paymentOrchestration.handle(message);
      case 'SHIPPING':
        return this.shippingOrchestration.handle(message);
    }
  }
}

import { BadRequestException } from '@nestjs/common';
import { FittingService } from './fitting.service';

describe('FittingService ownership checks', () => {
  it('rejects a fitting request when the order belongs to another customer', async () => {
    const orchestrator = { generatePreview: jest.fn() };
    const service = new FittingService(
      {} as any,
      orchestrator as any,
      {
        findOneForSeller: jest.fn().mockResolvedValue({ id: 'product-1' }),
      } as any,
      {
        findOneForSeller: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      } as any,
      {
        findOneForSeller: jest.fn().mockResolvedValue({
          customer_id: 'different-customer',
          item_details: [{ productId: 'product-1' }],
        }),
      } as any,
    );

    await expect(
      service.generatePreview('seller-1', {
        orderId: 'order-1',
        customerId: 'customer-1',
        productId: 'product-1',
        customerPhotoUrl: 'https://cdn.example/customer.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orchestrator.generatePreview).not.toHaveBeenCalled();
  });
});

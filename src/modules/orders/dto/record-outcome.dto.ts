import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { OrderOutcome } from '../../../common/enums';

/** Final delivery outcome reported by the courier / seller. */
export class RecordOutcomeDto {
  @ApiProperty({ enum: OrderOutcome, example: OrderOutcome.ACCEPTED })
  @IsEnum(OrderOutcome)
  outcome: OrderOutcome;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({ example: '+21620123456', description: 'E.164 phone number.' })
  @IsPhoneNumber(undefined, { message: 'phone must be a valid international number' })
  phone: string;

  @ApiPropertyOptional({ example: 'Amine Ben Salah' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'Tunis', description: 'Delivery zone / governorate.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  zone?: string;
}

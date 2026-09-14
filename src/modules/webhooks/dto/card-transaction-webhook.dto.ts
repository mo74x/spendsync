import {
  IsEnum,
  IsNumber,
  IsPositive,
  IsString,
  Length,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum TransactionType {
  PURCHASE = 'purchase',
  REFUND = 'refund',
  FEE = 'fee',
}

export class TransactionDataPayload {
  @IsString()
  transaction_id: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount: number;

  @IsString()
  @Length(3, 3)
  currency: string;

  @IsString()
  merchant: string;

  @IsString()
  category: string;

  @IsString()
  @Length(4, 4)
  card_last4: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsString()
  cost_center?: string;
}

export class CardTransactionWebhookDto {
  @IsString()
  event_id: string;

  @IsEnum(TransactionType)
  event_type: TransactionType;

  @ValidateNested()
  @Type(() => TransactionDataPayload)
  data: TransactionDataPayload;
}

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCostCenterMappingDto {
  @IsString()
  @IsNotEmpty()
  cost_center: string;

  @IsString()
  @IsNotEmpty()
  analytic_account_code: string;

  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateCostCenterMappingDto {
  @IsString()
  @IsNotEmpty()
  analytic_account_code: string;

  @IsString()
  @IsOptional()
  description?: string;
}

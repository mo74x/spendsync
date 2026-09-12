import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCategoryMappingDto {
  @IsString()
  @IsNotEmpty()
  category: string;

  @IsString()
  @IsNotEmpty()
  expense_account: string;

  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateCategoryMappingDto {
  @IsString()
  @IsNotEmpty()
  expense_account: string;

  @IsString()
  @IsOptional()
  description?: string;
}

import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class InventoryOrderDto {
  @IsString()
  @Matches(SKU_PATTERN)
  skuId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;
}

export class InventoryResetDto {
  @IsString()
  @Matches(SKU_PATTERN)
  skuId!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  stock!: number;
}

export class NaiveDelayDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000)
  delayMs?: number;
}

export class InventorySkuDto {
  @IsString()
  @Matches(SKU_PATTERN)
  skuId!: string;
}

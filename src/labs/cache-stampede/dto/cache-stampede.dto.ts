import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const PRODUCT_ID_PATTERN = /^product-[1-9][0-9]{0,5}$/;

export class ProductIdDto {
  @IsString()
  @Matches(PRODUCT_ID_PATTERN)
  productId!: string;
}

export class ResetCacheStampedeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  productCount?: number;
}

export class UpdateProductDto {
  @IsString()
  @Matches(/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣 _-]{0,99}$/)
  name!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  priceCents!: number;
}

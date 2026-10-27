import { Module } from '@nestjs/common'
import { CatalogController, CatalogService } from './catalog.service'
import { OcrService } from './ocr.service'
@Module({ controllers: [CatalogController], providers: [CatalogService, OcrService], exports: [CatalogService] })
export class CatalogModule {}

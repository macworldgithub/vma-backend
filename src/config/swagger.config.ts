import { DocumentBuilder } from '@nestjs/swagger';

export const swaggerConfig = new DocumentBuilder()
  .setTitle('VMA Backend')
  .setDescription('Meeting Assistant API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();
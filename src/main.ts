import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get('PORT') || 5000;
  const frontendUrl = configService.get('FRONTEND_URL') || 'http://localhost:3000';

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // CORS — allow frontend origin
  app.enableCors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  });

  // WebSocket adapter (Socket.IO)
  app.useWebSocketAdapter(new IoAdapter(app));

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('VMA Backend')
    .setDescription('Virtual Meeting Assistant API — Patterson Cheney Automotive Group')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth', 'Authentication & OTP verification')
    .addTag('Users', 'User management')
    .addTag('Meetings', 'Meeting lifecycle & room management')
    .addTag('Calendar', 'Calendar integration & sync')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Server running on http://0.0.0.0:${port}`);
  console.log(`📚 Swagger docs at http://0.0.0.0:${port}/docs`);
  console.log(`🔌 WebSocket server ready on ws://0.0.0.0:${port}`);
}
bootstrap();
import { MongooseModuleOptions } from '@nestjs/mongoose';

export const databaseConfig = (
  uri: string,
): MongooseModuleOptions => ({
  uri,
});
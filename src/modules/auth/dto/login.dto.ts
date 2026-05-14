import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString } from 'class-validator';
import { UserRole } from './register.dto';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'strongPassword123' })
  @IsString()
  password!: string;

  @ApiProperty({
    enum: UserRole,
    example: UserRole.STAFF,
    description: 'User role (admin or staff)',
  })
  @IsEnum(UserRole)
  role!: UserRole;
}

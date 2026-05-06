import { Controller, Get, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@Controller('users')
export class UsersController {
  constructor(private service: UsersService) {}

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  getAll() {
    return this.service.findAll();
  }
}
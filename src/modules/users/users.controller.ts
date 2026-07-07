import { Controller, Get, Post, UseGuards, Req, Patch, Param, Body, Delete, Query } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@Controller('users')
export class UsersController {
  constructor(private service: UsersService) {}

  @Get('me')
  @UseGuards(JwtGuard)
  getMe(@Req() req: any) {
    return this.service.findById(req.user.sub);
  }

  @Patch('me')
  @UseGuards(JwtGuard)
  updateMe(@Req() req: any, @Body() body: { name?: string; email?: string }) {
    return this.service.updateSelf(req.user.sub, body);
  }

  @Get()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  getAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    const pageNumber = page ? parseInt(page, 10) : 1;
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    return this.service.findAll(pageNumber, limitNumber, search, role);
  }

  @Post()
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  createUser(@Body() body: { name: string; email: string; password: string; role?: string }) {
    return this.service.createByAdmin(body);
  }

  @Patch(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id') id: string, @Body() body: any) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
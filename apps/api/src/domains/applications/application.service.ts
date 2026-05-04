import { errors } from '../../shared/errors/app-error.js';
import { paginate, parseCursor, type Paginated } from '../../shared/utils/pagination.js';
import type { Application } from '@prisma/client';
import type { IApplicationRepository } from './application.repository.js';
import type { ListApplicationsQuery } from './application.schemas.js';

export class ApplicationService {
  constructor(private readonly repo: IApplicationRepository) {}

  async list(query: ListApplicationsQuery): Promise<Paginated<Application>> {
    const cursor = parseCursor(query.cursor);
    const rows = await this.repo.list({
      partnerId: query.partnerId,
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor,
      limit: query.limit,
    });
    return paginate(rows, query.limit);
  }

  async getById(id: string): Promise<Application> {
    const row = await this.repo.findById(id);
    if (!row) throw errors.notFound('Application', id);
    return row;
  }
}

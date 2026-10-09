import type { Db } from '../db/client.js';

export class TrustedDomainService {
  constructor(private readonly db: Db) {}

  async list(): Promise<string[]> {
    const rows = await this.db.trustedDomain.findMany({ orderBy: { domain: 'asc' } });
    return rows.map((r) => r.domain);
  }

  async add(domain: string): Promise<boolean> {
    const res = await this.db.trustedDomain.createMany({ data: [{ domain }], skipDuplicates: true });
    return res.count === 1;
  }

  async remove(domain: string): Promise<boolean> {
    const res = await this.db.trustedDomain.deleteMany({ where: { domain } });
    return res.count === 1;
  }
}

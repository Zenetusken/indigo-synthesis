import { migrateDatabaseFromHostCli } from '../../src/platform/db/host-migrate'

await migrateDatabaseFromHostCli()
process.stdout.write('Database migrations are current.\n')

import { createFileRoute } from '@tanstack/react-router';
import { MigrationWorkspace, workspaceHead } from '@/components/migration-workspace';

export const Route = createFileRoute('/')({
  head: () => workspaceHead('Uploads'),
  component: () => <MigrationWorkspace section="uploads" />,
});
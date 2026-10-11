import { createFileRoute } from '@tanstack/react-router';
import { MigrationWorkspace, workspaceHead, sectionTitle } from '@/components/migration-workspace';

export const Route = createFileRoute('/workflow/$section')({
  head: ({ params }) => workspaceHead(sectionTitle(params.section)),
  component: Workflow,
});
function Workflow() {
  const { section } = Route.useParams();
  return <MigrationWorkspace section={section} />;
}
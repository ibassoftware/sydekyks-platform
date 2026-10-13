import { CapabilitiesTab } from './capabilities-tab';
import { ProvidersTab } from './providers-tab';
import { TiersTab } from './tiers-tab';

export default function AIProvidersPage({ section }: AIProvidersPageProps) {
  return <AICenter section={section} />;
}

function AICenter({ section }: { section: AISection }) {
  return (
    <div className="flex w-full flex-1 min-h-0 flex-col overflow-auto">
      <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-6">
        {section === 'providers' ? (
          <div className="flex flex-1 flex-col">
            <ProvidersTab />
          </div>
        ) : section === 'tiers' ? (
          <TiersTab />
        ) : (
          <CapabilitiesTab />
        )}
      </div>
    </div>
  );
}

type AISection = 'providers' | 'capabilities' | 'tiers';

type AIProvidersPageProps = {
  section: AISection;
};

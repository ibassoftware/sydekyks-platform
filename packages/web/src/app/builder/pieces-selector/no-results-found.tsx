import { t } from 'i18next';
import { SearchXIcon } from 'lucide-react';

const NoResultsFound = () => {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-full px-6 text-center">
      <div className="flex items-center justify-center size-12 rounded-full bg-gray-3">
        <SearchXIcon className="size-6 text-gray-11" />
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium text-gray-12">
          {t('No results found')}
        </div>
        <div className="text-xs text-gray-11">
          {t('Try a different search term')}
        </div>
      </div>
    </div>
  );
};

export { NoResultsFound };

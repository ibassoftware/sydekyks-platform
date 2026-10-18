import { t } from 'i18next';
import { Download } from 'lucide-react';
import React from 'react';

import { ImageWithFallback } from '@/components/custom/image-with-fallback';
import { useProtectedFileUrl } from '@/features/hosted-files/protected-file';

import { downloadImage } from './download-image';

interface ImageMessageProps {
  content: string;
  setSelectedImage: (image: string | null) => void;
}

export const ImageMessage: React.FC<ImageMessageProps> = ({
  content,
  setSelectedImage,
}) => {
  const imageUrl = useProtectedFileUrl(content);
  return (
    <div className="w-fit">
      <div className="relative group">
        <ImageWithFallback
          src={imageUrl}
          alt="Received image"
          className="w-80 h-auto rounded-md cursor-pointer"
          imageClassName="rounded-md"
          onClick={() => setSelectedImage(imageUrl ?? null)}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            downloadImage(imageUrl ?? '');
          }}
          data-theme="dark"
          aria-label={t('Download')}
          className="absolute top-2 right-2 bg-scrim/70 rounded-full p-1 hover:bg-scrim transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Download className="h-4 w-4 text-gray-12" />
        </button>
      </div>
    </div>
  );
};

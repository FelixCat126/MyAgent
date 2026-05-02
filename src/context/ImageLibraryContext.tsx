import { createContext, useContext } from 'react';

type ImageLibraryContextValue = {
  openImageLibrary: () => void;
};

export const ImageLibraryContext = createContext<ImageLibraryContextValue | null>(null);

export function useImageLibraryOpener(): () => void {
  const v = useContext(ImageLibraryContext);
  return v?.openImageLibrary ?? (() => {});
}

import React, { useState, useRef, DragEvent, ChangeEvent } from 'react';
import { FiUpload, FiX, FiFile, FiImage, FiVideo, FiMusic } from 'react-icons/fi';
import { useI18n } from '../hooks/useI18n';

interface FileUploaderProps {
  onFilesSelected: (files: File[]) => void;
  maxFiles?: number;
  maxSize?: number; // MB
  acceptedTypes?: string[];
}

const FileUploader: React.FC<FileUploaderProps> = ({
  onFilesSelected,
  maxFiles = 10,
  maxSize = 50, // 50MB
  acceptedTypes = ['image/*', 'application/pdf', 'text/*', 'audio/*', 'video/*'],
}) => {
  const { t } = useI18n();
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

  const handleFiles = (files: File[]) => {
    // 验证文件数量和大小
    if (files.length > maxFiles) {
      alert(t('fileUploader.tooMany', { max: maxFiles }));
      return;
    }

    const validFiles = files.filter((file) => {
      // 验证文件大小
      if (file.size > maxSize * 1024 * 1024) {
        alert(t('fileUploader.tooBig', { name: file.name, max: maxSize }));
        return false;
      }

      // 验证文件类型
      const isValidType = acceptedTypes.some((type) => {
        if (type.endsWith('/*')) {
          const prefix = type.slice(0, -2);
          return file.type.startsWith(prefix);
        }
        return file.type === type;
      });

      if (!isValidType) {
        alert(t('fileUploader.unsupported', { name: file.name }));
        return false;
      }

      return true;
    });

    setSelectedFiles(validFiles);
    onFilesSelected(validFiles);
  };

  const removeFile = (index: number) => {
    const newFiles = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(newFiles);
    onFilesSelected(newFiles);
  };

  const getFileIcon = (file: File) => {
    if (file.type.startsWith('image/')) return <FiImage />;
    if (file.type.startsWith('video/')) return <FiVideo />;
    if (file.type.startsWith('audio/')) return <FiMusic />;
    return <FiFile />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="space-y-3">
      {/* 拖拽上传区域 */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
            : 'border-gray-300 dark:border-gray-600 hover:border-primary-400 dark:hover:border-primary-500'
        }`}
      >
        <div className="flex flex-col items-center gap-2">
          <FiUpload size={24} className="text-gray-400 dark:text-gray-500" />
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {isDragging ? t('fileUploader.dropRelease') : t('fileUploader.dropHint')}
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {t('fileUploader.hint', { maxFiles, maxSize })}
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={acceptedTypes.join(',')}
          onChange={handleFileInput}
          className="hidden"
        />
      </div>

      {/* 已选文件列表 */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
            {t('fileUploader.selected', { n: selectedFiles.length })}
          </p>
          {selectedFiles.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-3 p-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800"
            >
              <div className="text-gray-500 dark:text-gray-400 text-lg">
                {getFileIcon(file)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {file.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {formatFileSize(file.size)}
                </p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(index);
                }}
                className="p-1 hover:bg-red-100 dark:hover:bg-red-900 rounded transition-colors text-gray-400 hover:text-red-600"
                title={t('fileUploader.removeFile')}
              >
                <FiX size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FileUploader;

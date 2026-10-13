import { SAFE_STRING_PATTERN } from '@activepieces/core-utils';
import { z } from 'zod';

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .regex(
    new RegExp(SAFE_STRING_PATTERN),
    'Name cannot contain periods or slashes',
  );

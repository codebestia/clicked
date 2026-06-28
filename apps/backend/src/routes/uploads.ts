import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and } from 'drizzle-orm';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { s3Client, S3_BUCKET } from '../lib/s3.js';
import { validate } from '../middleware/validate.js';

export const uploadsRouter: IRouter = Router();

uploadsRouter.use(requireAuth);

const RequestUploadSchema = z.object({
  size: z.number().int().positive(),
  sha256: z.string().optional(),
  mimeType: z.string().optional().default('application/octet-stream'),
});

// 1. Request upload URL
uploadsRouter.post('/', validate(RequestUploadSchema), async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const { size, sha256, mimeType } = req.body as z.infer<typeof RequestUploadSchema>;

  try {
    // We insert a pending file record
    const [file] = await db
      .insert(files)
      .values({
        uploaderId: userId,
        objectKey: `uploads/${userId}/${Date.now()}_${Math.random().toString(36).substring(7)}`,
        size,
        sha256,
        status: 'pending',
      })
      .returning();

    // Generate a presigned URL for upload
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: file.objectKey,
      ContentType: mimeType,
      ...(sha256 ? { ChecksumSHA256: sha256 } : {}),
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.status(201).json({
      fileId: file.id,
      uploadUrl: presignedUrl,
      objectKey: file.objectKey,
    });
  } catch (error) {
    console.error('Error creating presigned URL:', error);
    res.status(500).json({ error: 'Failed to request upload' });
  }
});

// 2. Complete/confirm upload
uploadsRouter.post('/:id/complete', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const fileId = req.params['id'] as string;

  try {
    const file = await db.query.files.findFirst({
      where: and(eq(files.id, fileId), eq(files.uploaderId, userId)),
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    if (file.status === 'ready') {
      res.status(200).json({ fileId: file.id, status: 'ready' });
      return;
    }

    // Server HEADs the object
    const command = new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: file.objectKey,
    });

    const headResponse = await s3Client.send(command);

    // Verify size matches
    if (headResponse.ContentLength !== file.size) {
      res.status(400).json({ 
        error: 'Size mismatch', 
        expected: file.size, 
        actual: headResponse.ContentLength 
      });
      return;
    }

    // Optionally verify ciphertext sha256 (if provided in the database and by S3)
    // S3 might return it in ChecksumSHA256 depending on how it was uploaded
    if (file.sha256 && headResponse.ChecksumSHA256 && headResponse.ChecksumSHA256 !== file.sha256) {
      res.status(400).json({ 
        error: 'Hash mismatch', 
        expected: file.sha256, 
        actual: headResponse.ChecksumSHA256 
      });
      return;
    }

    // Flip the file to ready
    const [updatedFile] = await db
      .update(files)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(eq(files.id, fileId))
      .returning();

    res.status(200).json(updatedFile);
  } catch (error: any) {
    if (error.name === 'NotFound') {
      res.status(400).json({ error: 'Object not found in storage. Ensure upload is complete.' });
      return;
    }
    console.error('Error completing upload:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  }
});

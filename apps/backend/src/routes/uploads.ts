import { Router } from 'express';
import type { IRouter } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { conversationMembers, files } from '../db/schema.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const uploadsRouter: IRouter = Router();
uploadsRouter.use(requireAuth);

const s3 = new S3Client({
  region: process.env['AWS_REGION'] || 'us-east-1',
});
const bucketName = process.env['AWS_BUCKET'] || 'clicked-files';

uploadsRouter.post('/', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const { fileId, conversationId, size, sha256 } = req.body;

  if (!fileId || !conversationId || typeof size !== 'number') {
    res.status(400).json({ error: 'fileId, conversationId, and size are required' });
    return;
  }

  const membership = await db.query.conversationMembers.findFirst({
    where: and(
      eq(conversationMembers.conversationId, conversationId),
      eq(conversationMembers.userId, userId),
    ),
  });

  if (!membership) {
    res.status(403).json({ error: 'Not authorized for this conversation' });
    return;
  }

  // Insert pending file record
  try {
    await db.insert(files).values({
      id: fileId,
      conversationId,
      uploaderId: userId,
      size,
      sha256: sha256 || null,
      status: 'pending',
    });
  } catch (err) {
    res.status(409).json({ error: 'File upload already initiated' });
    return;
  }

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: fileId,
    });
    // Signed URL for uploading directly to S3
    const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    res.json({ url: presignedUrl });
  } catch {
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

uploadsRouter.post('/:fileId/complete', async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const fileId = req.params['fileId'] as string;

  if (!fileId) {
    res.status(400).json({ error: 'File id is required' });
    return;
  }

  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
  });

  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  if (file.uploaderId !== userId) {
    res.status(403).json({ error: 'Not authorized to complete this upload' });
    return;
  }

  if (file.status === 'ready') {
    res.json({ success: true, message: 'Already completed' });
    return;
  }

  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: fileId,
    });
    const headResponse = await s3.send(headCommand);

    if (headResponse.ContentLength !== file.size) {
       res.status(400).json({ error: 'Size mismatch', details: 'File size in storage does not match declared size' });
       return;
    }

    await db.update(files)
      .set({ status: 'ready' })
      .where(eq(files.id, fileId));

    res.json({ success: true, message: 'Upload confirmed' });
  } catch (err: any) {
    if (err.name === 'NotFound') {
      res.status(400).json({ error: 'File not found in storage' });
    } else {
      res.status(500).json({ error: 'Failed to verify file upload' });
    }
  }
});

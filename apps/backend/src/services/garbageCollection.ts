import { lt, and, eq } from 'drizzle-orm';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';

const s3 = new S3Client({
  region: process.env['AWS_REGION'] || 'us-east-1',
});
const bucketName = process.env['AWS_BUCKET'] || 'clicked-files';

let gcInterval: ReturnType<typeof setInterval> | null = null;

export async function runGarbageCollection() {
  const ONE_DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  try {
    const oldPendingFiles = await db.query.files.findMany({
      where: and(
        eq(files.status, 'pending'),
        lt(files.createdAt, ONE_DAY_AGO)
      ),
    });

    for (const file of oldPendingFiles) {
      try {
        await s3.send(new DeleteObjectCommand({
          Bucket: bucketName,
          Key: file.id,
        }));
      } catch (err) {
        console.error(`[GC] Failed to delete file ${file.id} from S3`, err);
      }
      
      await db.delete(files).where(eq(files.id, file.id));
    }
  } catch (err) {
    console.error('[GC] Garbage collection failed', err);
  }
}

export function startGarbageCollection() {
  if (gcInterval) return;
  // Run every hour
  gcInterval = setInterval(() => {
    runGarbageCollection().catch(console.error);
  }, 60 * 60 * 1000);
}

export function stopGarbageCollection() {
  if (gcInterval) {
    clearInterval(gcInterval);
    gcInterval = null;
  }
}

# Presence, Heartbeat & Connection Liveness

This document describes the Redis-backed presence tracking system, how it handles heartbeat timing, and how it manages connection liveness across multiple devices.

## Overview

The presence system ensures that the application knows in real-time whether a user is online, which devices they are using, and maintains active connection mappings for real-time features like Socket.IO room subscriptions.

## Redis Key Structure

The system uses Redis for fast, TTL-based presence tracking.

| Redis Key Pattern | Type | Description |
| :--- | :--- | :--- |
| `presence:user:{userId}` | Hash | Maps `deviceId` to the timestamp of the last heartbeat received from that device. |
| `presence:user:{userId}:device:{deviceId}` | Hash | Per-device key with `PRESENCE_TTL` to track activity. TTL expiration acts as a heartbeat timeout. |
| `presence:sockets:{userId}` | Set | Contains all `socketId`s currently connected for this `userId`. |
| `presence:device_sockets:{userId}:{deviceId}` | Set | Contains `socketId`s specifically for a given device. |
| `presence:socket:{socketId}` | Hash | Maps `socketId` back to `userId` and `deviceId`. Used for cleanup. |

## Heartbeat & Connection Liveness

The connection liveness is maintained by a client-server heartbeat mechanism.

- **Heartbeat Interval/Timeout**: The client is expected to send a `heartbeat` event regularly.
- **Heartbeat Timeout (`HEARTBEAT_TIMEOUT_MS`)**: 90 seconds. If a client fails to send a `heartbeat` within 90 seconds of the last activity, the server considers that specific device session dead.
- **Database Update Throttle (`LAST_SEEN_THROTTLE_MS`)**: 30 seconds. To minimize database write pressure, `devices.lastSeenAt` is updated in the SQL database at most once every 30 seconds, even if heartbeats are received more frequently.

When a heartbeat is received:
1.  `refreshPresence` updates the Redis hash (`presence:user:{userId}`) and per-device TTL.
2.  `refreshPresenceSocket` refreshes the TTLs for the socket mappings.
3.  If 30 seconds have passed, the SQL database `devices` table `lastSeenAt` is updated.

## Multi-device Aggregation

The system handles multiple devices per user seamlessly.

1.  **Online Status**: A user is considered "online" if **any** non-revoked device has a heartbeat within the 90-second TTL window.
2.  **Transition Broadcast**: When a device connection is lost (due to heartbeat timeout or disconnection):
    - The server removes the socket mapping and potentially the device-level presence entry.
    - If the removed device was the **last active device** for that user, the server broadcasts `user_offline` and `presence_update` events to all conversations the user is a member of.
3.  **Reconciliation**: On gateway boot (e.g., after a deployment), the system reconciles existing Redis socket mappings with active Socket.IO connections and rebuilds room memberships.

import { Controller, Post, Body, HttpCode, HttpStatus, Logger, BadRequestException } from '@nestjs/common';
import { IdempotencyService } from '../services/idempotency.service';

interface InboundEventDto {
  eventId: string;
  deviceId: string;
  payload: any;
}

@Controller('events')
export class EventController {
  private readonly logger = new Logger(EventController.name);

  constructor(private readonly idempotencyService: IdempotencyService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async ingestEvent(@Body() eventDto: InboundEventDto) {
    const { eventId, deviceId, payload } = eventDto;

    // Fast-fail if required validation elements are completely missing from the request body
    if (!eventId || !deviceId) {
      throw new BadRequestException('Missing structural requirements: eventId and deviceId are mandatory.');
    }

    // Intercept event handling stream with our check-and-set Redis guardrail
    const isDuplicate = await this.idempotencyService.isDuplicateEvent(deviceId, eventId);

    if (isDuplicate) {
      this.logger.warn(`Replay protection triggered: Dropped duplicate eventId "${eventId}" from device "${deviceId}"`);
      
      // Return an 'ignored' status acknowledgment back to the client. 
      // Using an HTTP 200 OK prevents flaky client networks from continuously retrying an already cached event.
      return { 
        status: 'ignored', 
        reason: 'duplicate',
        eventId 
      };
    }

    this.logger.log(`Processing legitimate distinct event: ${eventId} for device: ${deviceId}`);

    // ... Place your downstream event processing, persistence, or message delivery hooks here ...

    return { 
      status: 'processed', 
      eventId 
    };
  }
}
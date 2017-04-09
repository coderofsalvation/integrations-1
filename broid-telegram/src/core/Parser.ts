import {
  default as schemas,
  IActivityStream,
} from '@broid/schemas';
import { cleanNulls, concat, fileInfo, isUrl, Logger } from '@broid/utils';

import * as Promise from 'bluebird';
import * as mimetype from 'mimetype';
import * as R from 'ramda';

export class Parser {
  public serviceID: string;
  public generatorName: string;
  private logger: Logger;

  constructor(serviceName: string, serviceID: string, logLevel: string) {
    this.serviceID = serviceID;
    this.generatorName = serviceName;
    this.logger = new Logger('parser', logLevel);
  }

  // Validate parsed data with Broid schema validator
  public validate(event: any): Promise<IActivityStream> {
    this.logger.debug('Validation process', { event });

    const parsed = cleanNulls(event);
    if (!parsed || R.isEmpty(parsed)) { return Promise.resolve(null); }

    if (!parsed.type) {
      this.logger.debug('Type not found.', { parsed });
      return Promise.resolve(null);
    }

    return schemas(parsed, 'activity')
      .then(() => parsed)
      .catch((err) => {
        this.logger.error(err);
        return null;
      });
  }

  // Convert normalized data to Broid schema
  public parse(event: any): Promise<IActivityStream> {
    this.logger.debug('Normalize process', { event });

    const normalized = cleanNulls(event);
    if (!normalized || R.isEmpty(normalized)) { return Promise.resolve(null); }

    const activitystreams = this.createActivityStream(normalized);
    activitystreams.actor = {
      id: R.toString(R.path(['from', 'id'], normalized)),
      name: concat([
          R.path(['from', 'first_name'], normalized),
          R.path(['from', 'last_name'], normalized),
        ]),
      type: 'Person',
    };

    const chatType: string = R.path(['chat', 'type'], normalized) as string || '';
    activitystreams.target = {
      id: R.toString(R.path(['chat', 'id'], normalized)),
      name: R.path(['chat', 'title'], normalized) || concat([
          R.path(['chat', 'first_name'], normalized),
          R.path(['chat', 'last_name'], normalized),
        ]),
      type: R.toLower(chatType) === 'private'
        ? 'Person' : 'Group',
    };

    // Process potentially media.
    if (normalized.type === 'Image' || normalized.type === 'Video') {
      let objType = 'Image';
      if (normalized.type === 'Video') {
        objType = 'Video';
      }

      const infos = fileInfo(normalized.text);
      activitystreams.object = {
        id: normalized.message_id.toString() || this.createIdentifier(),
        mediaType: infos.mimetype,
        name: normalized.text.split('/').pop(),
        type: objType,
        url: normalized.text,
      };
    }

    if (!activitystreams.object && !R.isEmpty(normalized.text)) {
      if (isUrl(normalized.text)) {
        const infos = fileInfo(normalized.text);
        const mediaType = infos.mimetype;
        if (mediaType.startsWith('image/')) {
          activitystreams.object = {
            id: normalized.eventID || this.createIdentifier(),
            mediaType,
            name: normalized.text.split('/').pop(),
            type: 'Image',
            url: normalized.text,
          };
        } else if (mediaType.startsWith('video/')) {
          activitystreams.object = {
            id: normalized.eventID || this.createIdentifier(),
            mediaType,
            name: normalized.text.split('/').pop(),
            type: 'Video',
            url: normalized.text,
          };
        }
      } else {
        activitystreams.object = {
          content: normalized.text,
          id: normalized.message_id.toString() || this.createIdentifier(),
          type: 'Note',
        };
      }
    }

    if (activitystreams.object && normalized.chat_instance) {
      activitystreams.object.context = {
        content: normalized.chat_instance.toString(),
        name: 'chat_instance',
        type: 'Object',
      };
    }

    return Promise.resolve(activitystreams);
  }

  // Normalize the raw event
  public normalize(evt: any): Promise<any> {
    this.logger.debug('Event received to normalize');

    const event = cleanNulls(evt);
    if (!event || R.isEmpty(event)) { return Promise.resolve(null); }

    event.timestamp = event.date || Math.floor(Date.now() / 1000);

    if (event._event === 'callback_query'
      || event._event === 'inline_query'
      || event._event === 'chosen_inline_result') {
      return Promise.resolve({
        chat: R.path(['message', 'chat'], event),
        chat_instance: event.chat_instance,
        from: event.from,
        message_id: event.id,
        text: event.data,
        timestamp: R.path(['message', 'date'], event) || event.timestamp,
      });
    }

    return Promise.resolve(event);
  }

  private createIdentifier(): string {
    return uuid.v4();
  }

  private createActivityStream(normalized: any): IActivityStream {
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      'generator': {
        id: this.serviceID,
        name: this.generatorName,
        type: 'Service',
      },
      'published': normalized.timestamp || Math.floor(Date.now() / 1000),
      'type': 'Create',
    };
  }
}

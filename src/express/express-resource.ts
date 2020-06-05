import {
  MiddlewareType,
  ResourceDefinition,
  RouteMethod,
  UnthinkMiddleware
} from '@epandco/unthink-foundation/lib/core';
import { RequestHandler } from 'express';
import { ExpressMiddleware } from './unthink-express-generator';


/**
 * This function wraps Express middleware to make it compatible UnthinkMiddleware.
 */
export function expressMiddleware(handler: RequestHandler): ExpressMiddleware {
  const expressHandler = handler as ExpressMiddleware;
  expressHandler.__expressMiddleware = 'EXPRESS_MIDDLEWARE';
  expressHandler.__middlewareType = MiddlewareType.RAW;

  return expressHandler;
}

/**
 * @deprecated This function has been deprecated since version 2 and will be removed in next major version.
 *             Please use the unthinkResource function as a replacement found in the unthink-foundation package.
 */
export function expressResource(resourceDefinition: ResourceDefinition<RequestHandler>): ResourceDefinition<UnthinkMiddleware> {
  /**
   * This explicit cast to the target type is intentional and done to simplify the conversation.
   *
   * The middleware is the only difference between them and by using Object.assign and the cast the new object is
   * pretty much assigned just need to wrap the raw middleware via expressMiddleware and the type will be complete.
   */
  const resource: ResourceDefinition<UnthinkMiddleware> = (Object.assign({}, resourceDefinition) as unknown) as ResourceDefinition<UnthinkMiddleware>;

  resource.middleware = resourceDefinition.middleware?.map(expressMiddleware);

  for (const route of resource.routes) {
    route.middleware = route.middleware?.map(
      // This looks odd but due to the cast above the middleware looks like the correct type, UnthinkMiddleware, but
      // in reality is still RequestHandler and needs to be converted. So have to cast to unknown and then back to the
      // original RequestHandler type.
      p => expressMiddleware((p as unknown) as RequestHandler)
    );

    for (const method in route.methods) {
      const resourceHandlerObj = route.methods[method as RouteMethod];

      if (!resourceHandlerObj) {
        throw new Error('Handler must be defined.');
      }

      if ('handler' in resourceHandlerObj) {
        // This looks odd but due to the cast above the middleware looks like the correct type, UnthinkMiddleware, but
        // in reality is still RequestHandler and needs to be converted. So have to cast to unknown and then back to the
        // original RequestHandler type.
        resourceHandlerObj.middleware = resourceHandlerObj.middleware?.map(p => expressMiddleware((p as unknown) as RequestHandler));
      }
    }
  }

  return resource;
}
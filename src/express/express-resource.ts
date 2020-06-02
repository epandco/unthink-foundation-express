import {
  MiddlewareType,
  ResourceDefinition,
  RouteMethod,
  UnthinkMiddleware
} from '@epandco/unthink-foundation/lib/core';
import { RequestHandler } from 'express';
import { ExpressMiddleware } from './unthink-express-generator';


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
  const resource: ResourceDefinition<UnthinkMiddleware> = (Object.assign({}, resourceDefinition) as unknown) as ResourceDefinition<UnthinkMiddleware>;

  resource.middleware = resourceDefinition.middleware?.map(expressMiddleware);

  for (const route of resource.routes) {
    route.middleware = route.middleware?.map(
      p => expressMiddleware((p as unknown) as RequestHandler)
    );

    for (const method in route.methods) {
      const resourceHandlerObj = route.methods[method as RouteMethod];

      if (!resourceHandlerObj) {
        throw new Error('Handler must be defined.');
      }

      if ('handler' in resourceHandlerObj) {
        resourceHandlerObj.middleware = resourceHandlerObj.middleware?.map(p => expressMiddleware((p as unknown) as RequestHandler));
      }
    }
  }

  return resource;
}
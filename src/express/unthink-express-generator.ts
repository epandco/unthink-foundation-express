import * as pino from 'express-pino-logger';
import { urlPathJoin } from '../utility/url-path-join';

import {
  Cookie,
  DataResult,
  MiddlewareResult,
  MiddlewareType,
  ResourceDefinition,
  ResourceRouteDefinition,
  ResourceRouteHandlerBase,
  Result,
  RouteContext,
  RouteMethod,
  RouteType,
  UnthinkGeneratorBackend,
  UnthinkMiddleware,
  UnthinkMiddlewareHandler,
  UnthinkRawMiddleware,
  UnthinkViewRenderer,
  ViewResult
} from '@epandco/unthink-foundation/lib/core';

import {
  Application,
  CookieOptions,
  ErrorRequestHandler,
  json,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router
} from 'express';


export interface ExpressMiddleware extends UnthinkRawMiddleware, RequestHandler {
  __expressMiddleware: 'EXPRESS_MIDDLEWARE';
}

interface GeneratedRoute {
  prefix: string;
  router: Router;
}

interface GeneratedDefinition {
  path: string;
  router: Router;
}

interface MiddlewareEndHandler {
  (result: MiddlewareResult, resp: Response): void;
}

function setHeaders(req: Request, resp: Response, headers?: Record<string, string>): void {
  if (!headers) {
    return;
  }

  for (const name in headers) {
    if (name.toLowerCase() === 'content-type') {
      req.log.error('skipping content-type - this cant be set directly');
      continue;
    }

    const currentValue = resp.getHeader(name);
    const newValue = headers[name];
    if (currentValue) {
      req.log.error(`Replacing header value for ${name}. Old: ${currentValue} - New: ${newValue}`);
    }
    
    resp.set(name, newValue);
  }
}

function setCookie(resp: Response, cookie: Cookie): void {
  const options: CookieOptions = {};

  /*
   * Noticed the 'cookie' function below did not like having a full object of undefined properties.
   * The type suggests this is fine but 'maxAge' specifically seems to trip up with the function assuming
   * that if the property exists, even if undefined (per the type) then it should be a number.
   *
   * This feels like a slight rough spot between where types are generated for express but it's obviously not
   * typescript under and they way they check for 'undefined' seems to be if property doesn't exist.
   *
   * The code below creates an empty object and only adds the property to it if the value exist for that property
   * to avoid the problem above.
   */
  if (cookie.domain) {
    options.domain = cookie.domain;
  }

  if (cookie.expires) {
    options.expires = cookie.expires;
  }

  if (cookie.httpOnly) {
    options.httpOnly = cookie.httpOnly;
  }

  if (cookie.maxAge) {
    options.maxAge = cookie.maxAge;
  }

  if (cookie.path) {
    options.path = cookie.path;
  }

  if (cookie.sameSite) {
    options.sameSite = cookie.sameSite;
  }

  if (cookie.secure) {
    options.secure = cookie.secure;
  }

  resp.cookie(cookie.name, cookie.value, options);
}

function setCookies(req: Request, resp: Response, cookies?: Cookie[]): void {
  if (!cookies) {
    return;
  }

  /* If cookies are set then lets not replace existing cookies unless specified by the new cookie config */
  if (req.cookies) {
    for (const cookie of cookies) {
      const currentCookie = req.cookies[cookie.name];

      if (currentCookie && !cookie.overwrite) {
        req.log.error(`Keep existing cookie: ${cookie.name} based on config option to overwrite this cookie.`);
        continue;
      }

      if (currentCookie && cookie.overwrite) {
        req.log.error(`Overwriting cookie: ${cookie.name} based on config option to overwrite this cookie.`);
      }

      setCookie(resp, cookie);
    }
  } else {
    /* probably not huge gains but lets not worry about the checks for existing cookies if not exist on the request */
    for (const cookie of cookies) {
      setCookie(resp, cookie);
    }
  }
}

function convertHeaders(req: Request): Record<string, string> | undefined {
  if (!req.headers) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const name in req.headers) {
    const value = req.headers[name];

    if (value) {
      // Choosing to ignore the string[] part of this type definition.
      // Not clear why that is needed but can address it when it comes up.
      headers[name] = value as string;
    }
  }

  return headers;
}

function convertCookies(req: Request): Cookie[] | undefined {
  if (!req.cookies) {
    return undefined;
  }

  const cookies: Cookie[] = [];
  for (const name in req.cookies) {
    const value = req.cookies[name];

    cookies.push({
      name: name,
      value: value
    });
  }

  return cookies;
}

function buildRouteContext(req: Request, resp: Response): RouteContext {
  return {
    query: req.query,
    params: req.params,
    body: req.body,
    headers: convertHeaders(req),
    cookies: convertCookies(req),
    logger: req.log,
    local: resp.locals,
    path: req.path
  };
}

function mergeLocals(result: Result, resp: Response): void {
  if (result.local) {
    resp.locals = { ...resp.locals, ...result.local };
  }
}

function buildUnthinkError(error: unknown): { unthinkHandlerError: unknown} {
  if (error instanceof Error) {
    return { unthinkHandlerError: error.stack };
  }

  return { unthinkHandlerError: JSON.stringify(error) };
}

function redirect(result: Result, req: Request, resp: Response): boolean {
  if ((result.status === 301 || result.status === 302) && result.redirectUrl) {
    setHeaders(req, resp, result.headers);
    setCookies(req, resp, result.cookies);
    resp.redirect(result.status as number, result.redirectUrl as string);
    return true;
  }

  if ((result.status === 301 || result.status === 302) && !result.redirectUrl) {
    throw new Error(`When view result has a status of ${result.status} the redirect url MUST BE specified`);
  }

  return false;
}

function buildViewHandler(resourceRouteHandler: ResourceRouteHandlerBase<ViewResult>, render: UnthinkViewRenderer): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    resp.contentType('text/html');

    let error: unknown;
    try {
      const ctx = buildRouteContext(req, resp);

      const result = await resourceRouteHandler(ctx);

      // Merging this always because errors may use locals and needs to be passed down
      // to error handler.
      mergeLocals(result, resp);

      if (result.status === 200 && result.template) {
        const body = render(
          result,
          // Locals may have changed so rebuild context after merge locals above to ensure
          // render function gets latest locals.
          buildRouteContext(req, resp)
        );

        setHeaders(req, resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(200);
        resp.send(body);

        return;
      }

      if (redirect(result, req, resp)) {
        return;
      }

      if (result.status === 200 && !result.template) {
        error = new Error('When view result has a status of 200 the template MUST BE set!');
      } else {
        error = result;
      }
    } catch (e) {
      error = e;
    }

    next(error);
  };
}

function buildViewErrorHandler(render: UnthinkViewRenderer): ErrorRequestHandler {
  return async (err: unknown, req: Request, resp: Response, _next: NextFunction ): Promise<void> => {
    if (resp.headersSent) {
      req.log.error('Response already sent. This is likely a bug in the route pipeline in this package.');
      return;
    }

    const unknownErrorMessage = 'Unknown error.';
    if (!err) {
      req.log.error('No error passed into handler');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    if (!(err instanceof ViewResult) && !(err instanceof MiddlewareResult)) {
      req.log.error(buildUnthinkError(err), 'Unexpected error:');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    const result = err as Result;
    try {
      const view = render(result, buildRouteContext(req, resp));

      setHeaders(req, resp, result.headers);
      setCookies(req, resp, result.cookies);
      resp.status(result.status);
      resp.send(view);
      return;
    } catch (err) {
      req.log.error(buildUnthinkError(err), 'Failed to handle result');
      resp.status(500).send(unknownErrorMessage);
    }
  };
}

function buildDataHandler(resourceRouteHandler: ResourceRouteHandlerBase<DataResult>): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    let error: unknown;
    try {
      const ctx: RouteContext = buildRouteContext(req, resp);

      const result = await resourceRouteHandler(ctx);

      // merge locals to use downstream
      mergeLocals(result, resp);

      if (result.status === 200 && result.value) {
        setHeaders(req, resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(result.status).json(result.value);
        return;
      }

      if (result.status === 204 && !result.value) {
        setHeaders(req, resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(204).end();
        return;
      }

      if (redirect(result, req, resp)) {
        return;
      }

      if (result.status === 200 && !result.value) {
        error = new Error('The value MUST be set for data results when the status is 200.');
      } else if (result.status === 204 && result.value) {
        error = new Error('The value SHOULD NOT be set for data results when the status is 204');
      } else {
        error = result;
      }
    } catch (e) {
      error = e;
    }

    next(error);
  };
}

async function dataErrorHandler(err: unknown, req: Request, resp: Response, _next: NextFunction ): Promise<void> {
  if (resp.headersSent) {
    req.log.error('Response already sent. This is likely a bug in the route pipeline in this package.');
    return;
  }

  const unknownError = 'Unknown error.';
  if (!err) {
    req.log.error('No error passed into dataErrorHandler');
    resp.status(500).json(unknownError);
    return;
  }

  if (!(err instanceof DataResult) && !(err instanceof MiddlewareResult)) {
    req.log.error(buildUnthinkError(err), 'Unexpected error');
    resp.status(500).json(unknownError);
    return;
  }

  const result = err as Result;
  if (result.status !== 400 && result.status !== 401 && result.status !== 404) {
    req.log.error(`The status ${result.status} is not supported by this framework for data results.`);
    resp.status(500).json(unknownError);
    return;
  }

  if ((result.status === 401 || result.status === 404) && result.value) {
    req.log.error(`When the data result has a status of ${result.status} the value SHOULD NOT be set.`);
    resp.status(500).json('unknown error');
    return;
  }

  if (result.status === 400 && !result.value) {
    req.log.error('When the data result has a status of 400 the value should MUST be set.');
    resp.status(500).json('unknown error');
    return;
  }

  setHeaders(req, resp, result.headers);
  setCookies(req, resp, result.cookies);
  resp.status(result.status).json(result.value);
}

function dataEndHandler(
  result: MiddlewareResult,
  resp: Response): void {

  resp.status(result.status).json(result.value);
}

function viewEndHandler(
  result: MiddlewareResult,
  resp: Response): void {

  resp.contentType('text/html');
  resp.status(result.status).send(result.value);
}

function middlewareHandler(
  result: MiddlewareResult,
  endHandler: MiddlewareEndHandler,
  req: Request,
  resp: Response,
  next: NextFunction): void {

  mergeLocals(result, resp);

  if (!result.continue && !result.end) {
    next(result);
  }

  setHeaders(req, resp, result.headers);
  setCookies(req, resp, result.cookies);

  if (result.end) {
    return endHandler(result, resp);
  }

  if (result.continue) {
    next();
  }
}

async function asyncMiddlewareHandler(
  asyncResult: Promise<MiddlewareResult>,
  callback: (asyncResult: MiddlewareResult) => void): Promise<void> {
  const result = await asyncResult;

  return callback(result);
}

function buildMiddlewareHandler(
  handler: UnthinkMiddlewareHandler,
  endHandler: MiddlewareEndHandler): RequestHandler {
  return (req, res, next): void | Promise<void> => {
    const ctx = buildRouteContext(req, res);

    try {
      const result = handler(ctx);

      if (result instanceof Promise) {
        return asyncMiddlewareHandler(result, (asyncResult) => {
          middlewareHandler(asyncResult, endHandler, req, res, next, );
        });
      }

      middlewareHandler(result, endHandler, req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function wrapUnthinkMiddleware(handler: UnthinkMiddleware, routeType: RouteType): RequestHandler {
  if (handler.__middlewareType === MiddlewareType.RAW) {
    throw new Error('No need to wrap raw middleware');
  }

  switch (routeType) {
    case RouteType.DATA:
      return buildMiddlewareHandler(handler, dataEndHandler);
      break;
    case RouteType.VIEW:
      return buildMiddlewareHandler(handler, viewEndHandler);
      break;
    default:
      throw new Error(`Unsupported route type ${routeType}`);
  }
}

function processMiddleware(routeType: RouteType, middleware?: UnthinkMiddleware[]): RequestHandler[] | undefined {
  if (!middleware) {
    return undefined;
  }

  let filtered: UnthinkMiddleware[];

  // Only include the relevant middleware for the route type
  // It is not an error for it to be in the list especially from the resource level we just safely ignore it
  if (routeType === RouteType.DATA) {
    filtered = middleware.filter(p => p.__middlewareType !== MiddlewareType.VIEW);
  } else if (routeType === RouteType.VIEW) {
    filtered = middleware.filter(p => p.__middlewareType !== MiddlewareType.DATA);
  } else {
    throw new Error(`Route type ${routeType} is not supported`);
  }

  return filtered.map((handler) => {
    if (handler.__middlewareType !== MiddlewareType.RAW) {
      return wrapUnthinkMiddleware(handler, routeType);
    }

    if ('__expressMiddleware' in handler && (handler as ExpressMiddleware).__expressMiddleware === 'EXPRESS_MIDDLEWARE') {
      return handler as RequestHandler;
    }

    throw new Error(`Unsupported middleware ${JSON.stringify(handler)}`);
  });
}

export class UnthinkExpressGenerator implements UnthinkGeneratorBackend {
  private readonly app: Application;
  private readonly viewRenderer: UnthinkViewRenderer;
  private readonly logLevel: string;

  constructor(app: Application, viewRenderer: UnthinkViewRenderer, logLevel: string) {
    this.app = app;
    this.viewRenderer = viewRenderer;
    this.logLevel = logLevel;
  }

  generate(resourceDefinitions: ResourceDefinition<UnthinkMiddleware>[]): void {
    const generatedDefinitions = resourceDefinitions.flatMap(p => this.generateDefinition(p));

    this.app.use(json());
    this.app.use(pino({
      level: this.logLevel
    }));

    for (const { path, router } of generatedDefinitions) {
      this.app.use(path, router);
    }
  }

  generateRoute(resourceRouteDefinition: ResourceRouteDefinition<UnthinkMiddleware>, resourceMiddleware?: UnthinkMiddleware[]): GeneratedRoute {
    const router = Router();
    const route = router.route(resourceRouteDefinition.path);

    switch (resourceRouteDefinition.__routeType) {
      case 'DATA':
        router.use(dataErrorHandler);
        break;
      case 'VIEW':
        router.use(buildViewErrorHandler(this.viewRenderer));
        break;
    }

    const routeAndResourceLevelHandlers: RequestHandler[] = [];

    // Inject route type into the middleware pipeline in case raw middleware needs it.
    routeAndResourceLevelHandlers.push((_req, resp, next) => {
      resp.locals.__routeType = resourceRouteDefinition.__routeType;
      next();
    });

    const processedResourceMiddleware = processMiddleware(resourceRouteDefinition.__routeType, resourceMiddleware);
    if (processedResourceMiddleware) {
      routeAndResourceLevelHandlers.push(...processedResourceMiddleware);
    }

    const processedRouteMiddleware = processMiddleware(resourceRouteDefinition.__routeType, resourceRouteDefinition.middleware);
    if (processedRouteMiddleware) {
      routeAndResourceLevelHandlers.push(...processedRouteMiddleware);
    }

    route.all(routeAndResourceLevelHandlers);

    for (const method in resourceRouteDefinition.methods) {
      const resourceHandlerObj = resourceRouteDefinition.methods[method as RouteMethod];

      if (!resourceHandlerObj) {
        throw new Error('Handler must be defined.');
      }

      let resourceHandler: ResourceRouteHandlerBase;

      const handlers: RequestHandler[] = [];
      if ('handler' in resourceHandlerObj) {
        resourceHandler = resourceHandlerObj.handler;

        const processedHandlerMiddleware = processMiddleware(
          resourceRouteDefinition.__routeType,
          resourceHandlerObj.middleware
        );

        if (processedHandlerMiddleware) {
          handlers.push(...processedHandlerMiddleware);
        }
      } else {
        resourceHandler = resourceHandlerObj;
      }

      switch (resourceRouteDefinition.__routeType) {
        case 'DATA':
          handlers.push(
            buildDataHandler(resourceHandler as ResourceRouteHandlerBase<DataResult>)
          );
          break;
        case 'VIEW':
          handlers.push(
            buildViewHandler(
                resourceHandler as ResourceRouteHandlerBase<ViewResult>,
                this.viewRenderer
            )
          );
          break;
      }

      route[method as RouteMethod](...handlers);
    }

    return {
      prefix: resourceRouteDefinition.prefix ?? '',
      router: router
    };
  }

  generateDefinition(resourceDefinition: ResourceDefinition<UnthinkMiddleware>): GeneratedDefinition[] {
    const mapPrefixedRoutes = new Map<string, GeneratedDefinition>();

    for (const routeDef of resourceDefinition.routes) {
      const { prefix, router } = this.generateRoute(routeDef, resourceDefinition.middleware);

      if (!mapPrefixedRoutes.has(prefix)) {
        let basePath = resourceDefinition.basePath;

        if (!basePath) {
          console.log(`basePath is not defined for ${resourceDefinition.name} and being defaulted to '/'`);
          basePath = '/';
        }

        const urlPath = urlPathJoin([prefix ? prefix : '/', basePath]);
        const generatedDefinition: GeneratedDefinition = {
          path: urlPath,
          router: Router()
        };

        mapPrefixedRoutes.set(prefix, generatedDefinition);
      }

      mapPrefixedRoutes.get(prefix)?.router.use(router);
    }

    return Array.from(mapPrefixedRoutes.values());
  }
}

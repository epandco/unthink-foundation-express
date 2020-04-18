import * as path from 'path';
import {
  ResourceDefinition,
  ResourceRouteDefinition,
  ResourceRouteHandlerBase,
  RouteContext,
  RouteMethod,
  UnthinkGeneratorBackend,
  ViewResult,
  DataResult, UnthinkViewRenderer
} from '@epandco/unthink-foundation/lib/core';

import {
  Application,
  Router,
  RequestHandler,
  Request,
  Response,
  NextFunction,
  json,
  ErrorRequestHandler
} from 'express';

interface GeneratedRoute {
  prefix: string;
  router: Router;
}

interface GeneratedDefinition {
  path: string;
  router: Router;
}

function buildViewHandler(resourceRouteHandler: ResourceRouteHandlerBase<ViewResult>, render: UnthinkViewRenderer): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    resp.contentType('text/html');

    let error: unknown;
    try {
      const ctx: RouteContext = {
        query: req.query,
        params: req.params,
        body: req.body
      };

      const result = await resourceRouteHandler(ctx);

      if (result.status === 200 && result.template) {
        const body = render(
          result.template as string,
          result.value
        );
        resp.status(200);
        resp.send(body);

        return;
      }

      if ((result.status === 301 || result.status === 302) && result.redirectUrl) {
        resp.redirect(result.status as number, result.redirectUrl as string);
        return;
      }

      if ((result.status === 301 || result.status === 302) && !result.redirectUrl) {
        error = new Error(`When view result has a status of ${result.status} the redirect url MUST BE specified`);
      } if (result.status === 200 && !result.template) {
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
  return async (err: unknown, _req: Request, resp: Response, _next: NextFunction ): Promise<void> => {
    if (resp.headersSent) {
      console.log('Response already sent. This is likely a bug in the route pipeline in this package.');
      return;
    }

    const unknownErrorMessage = 'Unknown error.';
    if (!err) {
      console.log('No error passed into handler');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    if (!(err instanceof ViewResult)) {
      console.log('Unexpected error:', err);
      resp.status(500).send(unknownErrorMessage);
    }

    const result = err as ViewResult;
    if (!result.template) {
      console.log('Template not defined.');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    const view = render(result.template as string, result.value);

    resp.status(result.status);
    resp.send(view);
    return;
  };
}

function buildDataHandler(resourceRouteHandler: ResourceRouteHandlerBase<DataResult>): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    let error: unknown;
    try {
      const ctx: RouteContext = {
        query: req.query,
        params: req.params,
        body: req.body
      };

      const result = await resourceRouteHandler(ctx);

      if (result.status === 200 && result.value) {
        resp.status(result.status).json(result.value);
        return;
      }

      if (result.status === 204 && !result.value) {
        resp.status(204).end();
        return;
      }

      if (result.status === 200 && !result.value) {
        error = new Error('The value MUST be set for data results when the status is 200.');
      } else if (result.status === 201 && result.value) {
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

async function dataErrorHandler(err: unknown, _req: Request, resp: Response, _next: NextFunction ): Promise<void> {
  if (resp.headersSent) {
    console.log('Response already sent. This is likely a bug in the route pipeline in this package.');
    return;
  }

  const unknownError = 'Unknown error.';
  if (!err) {
    console.log('No error passed into handler');
    resp.status(500).json(unknownError);
    return;
  }

  if (!(err instanceof DataResult)) {
    console.log('Unexpected error:', err);
    resp.status(500).json(unknownError);
  }

  const result = err as DataResult;
  if (result.status !== 400 && result.status !== 401 && result.status !== 404) {
    console.log(`The status ${result.status} is not supported by this framework for data results.`);
    resp.status(500).json(unknownError);
  }

  if ((result.status === 401 || result.status === 404) && result.value) {
    console.log(`When the data result has a status of ${result.status} the value SHOULD NOT be set.`);
    resp.status(500).json('unknown error');
    return;
  }

  if (result.status === 400 && !result.value) {
    console.log('When the data result has a status of 400 the value should MUST be set.');
    resp.status(500).json('unknown error');
    return;
  }

  // TODO: Handle headers and cookies
  resp.status(result.status).json(result.value);
}

export class UnthinkExpressGenerator implements UnthinkGeneratorBackend<RequestHandler> {
  private readonly app: Application;
  private readonly viewRenderer: UnthinkViewRenderer;

  constructor(app: Application, viewRenderer: UnthinkViewRenderer) {
    this.app = app;
    this.viewRenderer = viewRenderer;
  }

  generate(resourceDefinitions: ResourceDefinition<RequestHandler>[]): void {
    const generatedDefinitions = resourceDefinitions.flatMap(p => this.generateDefinition(p));

    this.app.use(json());
    for (const { path, router } of generatedDefinitions) {
      this.app.use(path, router);
    }
  }

  generateRoute(resourceRouteDefinition: ResourceRouteDefinition<RequestHandler>): GeneratedRoute {
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

    if (resourceRouteDefinition.middleware && resourceRouteDefinition.middleware.length > 0) {
      route.all(...resourceRouteDefinition.middleware);
    }

    for (const method in resourceRouteDefinition.methods) {
      const resourceHandlerObj = resourceRouteDefinition.methods[method as RouteMethod];

      if (!resourceHandlerObj) {
        throw new Error('Handler must be defined.');
      }

      let resourceHandler: ResourceRouteHandlerBase;

      const handlers: RequestHandler[] = [];
      if ('handler' in resourceHandlerObj) {
        resourceHandler = resourceHandlerObj.handler;
        handlers.push(...resourceHandlerObj.middleware);
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

  generateDefinition(resourceDefinition: ResourceDefinition<RequestHandler>): GeneratedDefinition[] {
    const mapPrefixedRoutes = new Map<string, GeneratedDefinition>();

    for (const routeDef of resourceDefinition.routes) {
      const { prefix, router } = this.generateRoute(routeDef);

      if (!mapPrefixedRoutes.has(prefix)) {
        let basePath = resourceDefinition.basePath;

        if (!basePath) {
          console.log(`basePath is not defined for ${resourceDefinition.name} and being defaulted to '/'`);
          basePath = '/';
        }

        const urlPath = path.join(prefix, basePath);
        const generatedDefinition: GeneratedDefinition = {
          path: urlPath,
          router: Router()
        };

        if (resourceDefinition.middleware && resourceDefinition.middleware.length > 0) {
          generatedDefinition.router.use(...resourceDefinition.middleware);
        }

        mapPrefixedRoutes.set(prefix, generatedDefinition);
      }

      mapPrefixedRoutes.get(prefix)?.router.use(router);
    }

    return Array.from(mapPrefixedRoutes.values());
  }
}